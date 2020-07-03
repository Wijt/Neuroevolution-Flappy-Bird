class Button{
    constructor(x, y, width, height, text, color, fnc) {
        this.pos = {x:x, y: y};
        this.height = height;
        this.width = width;
        this.rect = {x1: x - width / 2, y1: y - height / 2, x2: x + width / 2, y2: y + height / 2};
        this.text = text;
        this.color = color;
        this.func = fnc;
        buttons.push(this);
    }

    show(){
        let scaleRatio=1;
        push();
            if(isInside({x:mouseX, y:mouseY}, this.rect)){
                //translate(this.pos.x, this.pos.y);
                scaleRatio = 1.1;
            }

            scale(scaleRatio); 
            
            rectMode(CENTER);
            fill(this.color);
            rect(this.pos.x/scaleRatio, this.pos.y/scaleRatio, this.width, this.height, 15);
            
            textAlign(CENTER, CENTER);
            fill(0);
            textSize((this.height-15)/scaleRatio);
            text(this.text, this.pos.x/scaleRatio, this.pos.y/scaleRatio);    
        pop();
    }
}