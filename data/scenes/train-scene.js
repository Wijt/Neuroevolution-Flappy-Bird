class TrainScene extends Scene {
    constructor() {
        super();
        
        this.birds = [];
        this.deadBirds = [];
        this.pipes;

        this.generation = 0;
        this.maxScore = 0;
        
        this.gameStarted = false;

        this.nextPipe = null;

        this.returnToMenuButton;
    }

    setupUI() {
        if (this.returnToMenuButton != null) return;

        this.returnToMenuButton = createButton('<');
        let bottomLeftCorner = createVector();
        this.returnToMenuButton.size(30, 30);
        bottomLeftCorner.x = innerWidth/2 - width/2 + 10;
        bottomLeftCorner.y = innerHeight - (innerHeight - height)/2 - 40;
        this.returnToMenuButton.position(bottomLeftCorner.x, bottomLeftCorner.y);
        this.returnToMenuButton.mousePressed(() => {
            this.sceneManager.openScene(MENU_SCENE);
            this.returnToMenuButton.remove(); //to pervent any bug
            this.returnToMenuButton = null;
        });
    }

    start() {
        super.start();

        this.setupUI();

        this.generation++;
        this.setPopulation();
        
        this.pipes = [];

        let pipeCount = width / (PIPE_BETWEEN + PIPE_WIDTH);
    

        for (let i = 1; i <= pipeCount + 2; i++) {
            new Pipe(width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH), random(PIPE_NO_GAP_ZONE, height-PIPE_NO_GAP_ZONE));
        }
            
        this.gameStarted = true;
    }

    update() {
        super.update();
    
        if (!this.gameStarted) return;

        this.pipes.forEach(pipe => {
            pipe.update();
        });

     
        //select next pipe for flappy bird.
        //pipe.bottomPipe.x1 > BIRD_X - (PIPE_WIDTH + BIRD_R)
        //this should be the selecting criterion because superBird learn with this. otherwise it is not perform that good
        this.nextPipe = this.pipes.filter(pipe => pipe.bottomPipe.x1 > BIRD_X - (PIPE_WIDTH + BIRD_R))[0];

        if (this.nextPipe != null) {
            this.birds.forEach(bird =>{

                let inputs = [];
                inputs[0] = this.nextPipe.bottomPipe.x1;
                inputs[1] = bird.pos.y;
                inputs[2] = bird.velocity;
                inputs[3] = this.nextPipe.bottomPipe.y1;
                inputs[4] = this.nextPipe.topPipe.y2;

                bird.inputs = inputs;
                bird.update();

                // kill the player if hit a pipe
                let hitted = circleRect(bird, this.nextPipe.topPipe) || circleRect(bird, this.nextPipe.bottomPipe);
                if (hitted){
                    bird.live = false;
                } 
                
                // give the player a point if he passed a pipe
                if (bird.pos.x > this.nextPipe.pos.x && bird.lastEarnedScoresPipe != this.nextPipe) {
                    bird.lastEarnedScoresPipe = this.nextPipe;
                    bird.score++;
                    bird.fitness += 10000;
                }

                // check if the player hit the ground
                if (bird.pos.y > height - GROUND_HEIGHT) {
                    bird.live = false;
                }

                // check if the player hit the ceiling
                if (bird.pos.y - BIRD_R/2 < 0) {
                    bird.live = false;
                }

                if (!bird.live) {
                    bird.fitness -= 30000;
                    this.birds.splice(this.birds.indexOf(bird), 1);
                    this.deadBirds.push(bird);
                }
            });
        }

        if (!(this.birds.length > 0)) this.start();

        if (this.birds[0].score > this.maxScore) this.maxScore = this.birds[0].score;

    }

    draw() {      
        background(color(BG_COLOR));

        this.pipes.forEach(pipe => {
            pipe.show();
        });
        
        //Shows the nextPipe different
        //this.nextPipe.debugShow();

        //birds should be drawn after the pipes so it's not hidden by them when dieing
        this.birds.forEach(bird => {
            bird.show();
        });

        push(); //Ground drawing
            noStroke();
            fill(color(GROUND_COLOR));
            rect(0, height - GROUND_HEIGHT, width, GROUND_HEIGHT);
        pop();

        push(); //Train info drawing
            textAlign(LEFT);
            fill(255);
            textSize(12);
            text(`Maximum Achieved Score: ${this.maxScore}`, 10, 30)
            text(`Generation Count: ${this.generation}`, 10, 45)
        pop();
    }

    setPopulation(){
        let fittest = this.getFittestBird();
    
        this.birds = [];
        this.deadBirds = [];
        for (let i = 0; i < POPULATION_SIZE; i++) {
            //console.log(fittest.brain, fittest.brain.copy());
            let spawnedBird = new AIBird(BIRD_X, 500, fittest.brain.copy() || null);
            spawnedBird.brain.mutate();
            this.birds.push(spawnedBird);
        }
    }
    
    getFittestBird(){
        this.deadBirds.sort(function(a, b){
            return a.fitness - b.fitness;
        });
        return this.deadBirds[this.deadBirds.length - 1] || new AIBird(BIRD_X, 500, null);
    }
    
    saveFittest(){
    
    }
    
    loadFittest(){
    
    }
}